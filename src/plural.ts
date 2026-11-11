/** `1 loop`, `2 loops`: a count a person reads, never `loop(s)`. */
export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}
