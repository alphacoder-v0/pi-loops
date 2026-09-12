/**
 * A small TOML subset parser — enough for `mcp.toml`, `hooks.toml`
 * and `config.toml`: comments, `[table]`, `[[array.of.tables]]`, dotted table
 * headers, `key = value` with basic/literal strings, integers, floats, booleans,
 * single-line arrays of scalars and one level of inline tables. Anything fancier
 * (multi-line strings, dates, nested inline tables) throws with a line number.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
	[key: string]: TomlValue;
}

class Parser {
	private pos = 0;
	private readonly text: string;
	private readonly line: number;
	constructor(text: string, line: number) {
		this.text = text;
		this.line = line;
	}

	fail(msg: string): never {
		throw new Error(`TOML line ${this.line}: ${msg}`);
	}
	peek(): string {
		return this.text[this.pos] ?? "";
	}
	/** Consume `ch` or fail saying where it was expected: the one way a missing `=` is reported. */
	expect(ch: string, what: string): void {
		if (this.peek() !== ch) this.fail(`expected ${ch} ${what}`);
		this.pos++;
	}
	eof(): boolean {
		return this.pos >= this.text.length;
	}
	skipWs(): void {
		while (!this.eof() && (this.peek() === " " || this.peek() === "\t")) this.pos++;
	}
	rest(): string {
		return this.text.slice(this.pos);
	}

	parseValue(): TomlValue {
		this.skipWs();
		const c = this.peek();
		if (c === '"') return this.parseBasicString();
		if (c === "'") return this.parseLiteralString();
		if (c === "[") return this.parseArray();
		if (c === "{") return this.parseInlineTable();
		const m = /^(true|false|[+-]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|[+-]?(?:inf|nan))/.exec(this.rest());
		if (!m) this.fail(`unexpected value near "${this.rest().slice(0, 20)}"`);
		this.pos += m[0].length;
		if (m[0] === "true") return true;
		if (m[0] === "false") return false;
		const n = Number(m[0].replace(/_/g, ""));
		if (Number.isNaN(n)) this.fail(`bad number ${m[0]}`);
		return n;
	}

	parseBasicString(): string {
		this.pos++; // opening quote
		let out = "";
		for (;;) {
			if (this.eof()) this.fail("unterminated string");
			const c = this.text[this.pos++];
			if (c === '"') return out;
			if (c === "\\") {
				const e = this.text[this.pos++];
				const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" };
				if (e in map) out += map[e];
				else if (e === "u" || e === "U") {
					const len = e === "u" ? 4 : 8;
					const hex = this.text.slice(this.pos, this.pos + len);
					if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) this.fail("bad unicode escape");
					out += String.fromCodePoint(parseInt(hex, 16));
					this.pos += len;
				} else this.fail(`bad escape \\${e}`);
			} else out += c;
		}
	}

	parseLiteralString(): string {
		this.pos++;
		const end = this.text.indexOf("'", this.pos);
		if (end < 0) this.fail("unterminated literal string");
		const out = this.text.slice(this.pos, end);
		this.pos = end + 1;
		return out;
	}

	parseArray(): TomlValue[] {
		this.pos++;
		const out: TomlValue[] = [];
		for (;;) {
			this.skipWs();
			if (this.peek() === "]") {
				this.pos++;
				return out;
			}
			out.push(this.parseValue());
			this.skipWs();
			if (this.peek() === ",") {
				this.pos++;
				continue;
			}
			if (this.peek() === "]") {
				this.pos++;
				return out;
			}
			this.fail("expected , or ] in array");
		}
	}

	parseInlineTable(): TomlTable {
		this.pos++;
		const out: TomlTable = {};
		for (;;) {
			this.skipWs();
			if (this.peek() === "}") {
				this.pos++;
				return out;
			}
			const key = this.parseKey();
			this.skipWs();
			this.expect("=", "in inline table");
			out[key] = this.parseValue();
			this.skipWs();
			if (this.peek() === ",") {
				this.pos++;
				continue;
			}
			if (this.peek() === "}") {
				this.pos++;
				return out;
			}
			this.fail("expected , or } in inline table");
		}
	}

	parseKey(): string {
		this.skipWs();
		if (this.peek() === '"') return this.parseBasicString();
		if (this.peek() === "'") return this.parseLiteralString();
		const m = /^[A-Za-z0-9_-]+/.exec(this.rest());
		if (!m) this.fail(`bad key near "${this.rest().slice(0, 20)}"`);
		this.pos += m[0].length;
		return m[0];
	}

	/** `a.b.c` → ["a","b","c"] (quoted segments allowed). */
	parseDottedKey(): string[] {
		const parts = [this.parseKey()];
		this.skipWs();
		while (this.peek() === ".") {
			this.pos++;
			parts.push(this.parseKey());
			this.skipWs();
		}
		return parts;
	}

	expectEnd(): void {
		this.skipWs();
		if (!this.eof() && this.peek() !== "#") this.fail(`unexpected trailing "${this.rest().slice(0, 20)}"`);
	}
}

function stripComment(line: string): string {
	// Remove a trailing comment that is not inside a string.
	let inBasic = false;
	let inLiteral = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (inBasic) {
			if (c === "\\") i++;
			else if (c === '"') inBasic = false;
		} else if (inLiteral) {
			if (c === "'") inLiteral = false;
		} else if (c === '"') inBasic = true;
		else if (c === "'") inLiteral = true;
		else if (c === "#") return line.slice(0, i);
	}
	return line;
}

function descend(root: TomlTable, path: string[], lineNo: number): TomlTable {
	let cur: TomlTable = root;
	for (const seg of path) {
		let next = cur[seg];
		if (next === undefined) {
			next = {};
			cur[seg] = next;
		} else if (Array.isArray(next)) {
			const last = next[next.length - 1];
			if (!last || typeof last !== "object" || Array.isArray(last)) throw new Error(`TOML line ${lineNo}: ${seg} is not a table`);
			next = last;
		} else if (typeof next !== "object") throw new Error(`TOML line ${lineNo}: ${seg} is not a table`);
		cur = next as TomlTable;
	}
	return cur;
}

export function parseToml(text: string): TomlTable {
	const root: TomlTable = {};
	let current: TomlTable = root;
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		const raw = stripComment(lines[i]).trim();
		if (!raw) continue;
		if (raw.startsWith("[[")) {
			if (!raw.endsWith("]]")) throw new Error(`TOML line ${lineNo}: bad array table header`);
			const path = new Parser(raw.slice(2, -2), lineNo).parseDottedKey();
			const parent = descend(root, path.slice(0, -1), lineNo);
			const name = path[path.length - 1];
			let arr = parent[name];
			if (arr === undefined) {
				arr = [];
				parent[name] = arr;
			}
			if (!Array.isArray(arr)) throw new Error(`TOML line ${lineNo}: ${name} is not an array of tables`);
			const table: TomlTable = {};
			arr.push(table);
			current = table;
			continue;
		}
		if (raw.startsWith("[")) {
			if (!raw.endsWith("]")) throw new Error(`TOML line ${lineNo}: bad table header`);
			const path = new Parser(raw.slice(1, -1), lineNo).parseDottedKey();
			current = descend(root, path, lineNo);
			continue;
		}
		const p = new Parser(raw, lineNo);
		const keyPath = p.parseDottedKey();
		p.skipWs();
		p.expect("=", "after key");
		const value = p.parseValue();
		p.expectEnd();
		const target = descend(current, keyPath.slice(0, -1), lineNo);
		target[keyPath[keyPath.length - 1]] = value;
	}
	return root;
}
