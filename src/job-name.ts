/**
 * The name a loop gets when it is made without one: the first few words of what it does, so a
 * person refers to it as `check-new-issues` and not as a 32-digit id. Every creation path goes
 * through `createLoopJob`, which asks this once.
 */

const SKIP = new Set("a an the and or but of to in on at by for with from as is are be it its this that these those if when then than so me my i you your we our please".split(" "));
const WORDS = 3;
const WORD_CHARS = 12;

/** A short lowercase-hyphenated name from `text`, unique among `taken`. */
export function jobNameFrom(text: string, taken: ReadonlyArray<{ name?: string }>): string {
	const words = text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w && !SKIP.has(w))
		.slice(0, WORDS)
		.map((w) => w.slice(0, WORD_CHARS));
	const base = words.join("-") || "loop";
	const names = new Set(taken.map((j) => j.name));
	if (!names.has(base)) return base;
	let n = 2;
	while (names.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}
