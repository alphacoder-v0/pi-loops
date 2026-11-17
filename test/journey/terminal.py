import codecs
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import unicodedata


class Screen:
    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.wrapped = [False] * rows
        self.history = []
        self.history_wrapped = []
        self.y = self.x = 0
        self.saved = (0, 0)
        self.top, self.bottom = 0, rows - 1
        self.state, self.buf = "text", ""
        self.replies = []

    def scroll_up(self, n=1):
        for _ in range(n):
            if self.top == 0:
                self.history.append(self.grid[0])
                self.history_wrapped.append(self.wrapped[0])
                self.history = self.history[-2000:]
                self.history_wrapped = self.history_wrapped[-2000:]
            del self.grid[self.top]
            del self.wrapped[self.top]
            self.grid.insert(self.bottom, [" "] * self.cols)
            self.wrapped.insert(self.bottom, False)

    def scroll_down(self, n=1):
        for _ in range(n):
            del self.grid[self.bottom]
            del self.wrapped[self.bottom]
            self.grid.insert(self.top, [" "] * self.cols)
            self.wrapped.insert(self.top, False)

    def newline(self):
        if self.y == self.bottom:
            self.scroll_up()
        elif self.y < self.rows - 1:
            self.y += 1

    def put(self, ch):
        width = 0 if unicodedata.combining(ch) else (2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1)
        if not width:
            return
        if self.x + width > self.cols:
            self.wrapped[self.y] = True
            self.x = 0
            self.newline()
        self.grid[self.y][self.x] = ch
        if width == 2:
            self.grid[self.y][self.x + 1] = None
        self.x += width

    def clamp(self):
        self.y = max(0, min(self.rows - 1, self.y))
        self.x = max(0, min(self.cols - 1, self.x))

    def erase_line(self, mode):
        row = self.grid[self.y]
        indexes = range(self.x, self.cols) if mode == 0 else range(self.x + 1) if mode == 1 else range(self.cols)
        for i in indexes:
            row[i] = " "
        if mode == 2:
            self.wrapped[self.y] = False

    def csi(self, params, final, private):
        nums = [int(p) if p.isdigit() else 0 for p in params.split(";")] if params else []
        n = nums[0] if nums and nums[0] else 1
        if private:
            return
        if final == "A": self.y -= n
        elif final == "B": self.y += n
        elif final == "C": self.x += n
        elif final == "D": self.x -= n
        elif final == "E": self.y += n; self.x = 0
        elif final == "F": self.y -= n; self.x = 0
        elif final == "G": self.x = n - 1
        elif final == "d": self.y = n - 1
        elif final in "Hf":
            self.y = (nums[0] if nums and nums[0] else 1) - 1
            self.x = (nums[1] if len(nums) > 1 and nums[1] else 1) - 1
        elif final == "J":
            mode = nums[0] if nums else 0
            if mode == 0:
                self.erase_line(0)
                for r in range(self.y + 1, self.rows): self.grid[r] = [" "] * self.cols; self.wrapped[r] = False
            elif mode == 1:
                self.erase_line(1)
                for r in range(self.y): self.grid[r] = [" "] * self.cols
            else:
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
                self.wrapped = [False] * self.rows
        elif final == "K": self.erase_line(nums[0] if nums else 0)
        elif final == "X":
            for i in range(self.x, min(self.cols, self.x + n)): self.grid[self.y][i] = " "
        elif final == "P":
            row = self.grid[self.y]; del row[self.x:self.x + n]; row.extend([" "] * (self.cols - len(row)))
        elif final == "@":
            row = self.grid[self.y]; row[self.x:self.x] = [" "] * n; del row[self.cols:]
        elif final == "L":
            for _ in range(n):
                del self.grid[self.bottom]; self.grid.insert(self.y, [" "] * self.cols)
                del self.wrapped[self.bottom]; self.wrapped.insert(self.y, False)
        elif final == "M":
            for _ in range(n):
                del self.grid[self.y]; self.grid.insert(self.bottom, [" "] * self.cols)
                del self.wrapped[self.y]; self.wrapped.insert(self.bottom, False)
        elif final == "S": self.scroll_up(n)
        elif final == "T": self.scroll_down(n)
        elif final == "r":
            self.top = (nums[0] if nums and nums[0] else 1) - 1
            self.bottom = (nums[1] if len(nums) > 1 and nums[1] else self.rows) - 1
            self.y = self.x = 0
        elif final == "s": self.saved = (self.y, self.x)
        elif final == "u": self.y, self.x = self.saved
        elif final == "n" and nums and nums[0] == 6: self.replies.append(f"\x1b[{self.y + 1};{self.x + 1}R")
        elif final == "c": self.replies.append("\x1b[?62;22c")
        self.clamp()

    def feed(self, text):
        for ch in text:
            state = self.state
            if state == "text":
                if ch == "\x1b": self.state = "esc"
                elif ch == "\r": self.x = 0
                elif ch == "\n": self.newline()
                elif ch == "\b": self.x = max(0, self.x - 1)
                elif ch == "\t": self.x = min(self.cols - 1, (self.x // 8 + 1) * 8)
                elif ch < " " or ch == "\x7f": pass
                else: self.put(ch)
            elif state == "esc":
                if ch == "[": self.state, self.buf = "csi", ""
                elif ch == "]": self.state, self.buf = "osc", ""
                elif ch in "PX^_": self.state, self.buf = "str", ""
                elif ch == "7": self.saved = (self.y, self.x); self.state = "text"
                elif ch == "8": self.y, self.x = self.saved; self.state = "text"
                elif ch == "M":
                    if self.y == self.top: self.scroll_down()
                    else: self.y -= 1
                    self.state = "text"
                elif ch in "()*+": self.state = "charset"
                else: self.state = "text"
            elif state == "charset": self.state = "text"
            elif state == "csi":
                if "@" <= ch <= "~":
                    private = self.buf[0] if self.buf[:1] in ("?", ">", "<", "=") else ""
                    self.csi(self.buf[1:] if private else self.buf, ch, private)
                    self.state = "text"
                else: self.buf += ch
            elif state in ("osc", "str"):
                if ch == "\x07": self.state = "text"
                elif ch == "\x1b": self.state = state + "-esc"
                else: self.buf += ch
            elif state.endswith("-esc"):
                self.state = "text" if ch == "\\" else state[:-4]

    def snapshot(self, exited, seq):
        return {"rows": ["".join(ch or "" for ch in row).rstrip() for row in self.grid], "wrapped": self.wrapped,
                "history": ["".join(ch or "" for ch in row).rstrip() for row in self.history],
                "historyWrapped": self.history_wrapped, "exited": exited, "seq": seq}


def write_snapshot(directory, screen, exited, seq):
    temporary = os.path.join(directory, "screen.tmp")
    with open(temporary, "w", encoding="utf-8") as out:
        json.dump(screen.snapshot(exited, seq), out, ensure_ascii=False)
    os.replace(temporary, os.path.join(directory, "screen.json"))


def main():
    directory = os.environ["PTYTERM_DIR"]
    rows, cols = int(os.environ["PTYTERM_ROWS"]), int(os.environ["PTYTERM_COLS"])
    keys_fd = os.open(os.path.join(directory, "keys"), os.O_RDWR | getattr(os, "O_NONBLOCK", 0))
    pid, master = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    screen = Screen(rows, cols)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    pending = b""
    exited = False
    stopping = False
    seq = 0
    write_snapshot(directory, screen, exited, seq)
    while True:
        ready, _, _ = select.select([master, keys_fd], [], [], 0.05)
        changed = False
        if master in ready:
            try: data = os.read(master, 65536)
            except OSError: data = b""
            if data:
                screen.feed(decoder.decode(data))
                for reply in screen.replies: os.write(master, reply.encode())
                screen.replies.clear()
                changed = True
            elif not exited:
                exited = True
                changed = True
        if keys_fd in ready:
            try: pending += os.read(keys_fd, 65536)
            except OSError: pass
            while pending:
                if pending[0] == 0:
                    if b"\n" not in pending: break
                    line, pending = pending[1:].split(b"\n", 1)
                    try: request = json.loads(line)
                    except ValueError: continue
                    if request.get("clearHistory"):
                        screen.history.clear(); screen.history_wrapped.clear(); changed = True
                    if request.get("stop"):
                        stopping = True
                        try: os.kill(pid, signal.SIGTERM)
                        except ProcessLookupError: pass
                        stop_at = time.monotonic() + 2
                else:
                    end = pending.find(b"\0")
                    if end < 0: end = len(pending)
                    data, pending = pending[:end], pending[end:]
                    if not exited:
                        try: os.write(master, data)
                        except OSError: pass
        if stopping and not exited and time.monotonic() >= stop_at:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                exited = True
                changed = True
        except ChildProcessError:
            exited = True
        if changed:
            seq += 1
            write_snapshot(directory, screen, exited, seq)
        if exited:
            break
    os.close(master)
    os.close(keys_fd)


if __name__ == "__main__":
    main()
