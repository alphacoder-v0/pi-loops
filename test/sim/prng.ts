/**
 * The simulation's only source of chance: mulberry32, seeded with one integer. Thirty-two bits of
 * state are few, and enough: a seed has to spread schedules, not resist anyone, and it has to give
 * the same numbers on every machine and every Node, which `Math.random` does not.
 */
export type Random = () => number;

/** A generator of unsigned 32-bit integers from `seed`. */
export function prng(seed: number): Random {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (t ^ (t >>> 14)) >>> 0;
	};
}

/** One of `list` by a number the generator gave: the same number picks the same place in a list of the same length. */
export const pick = <T>(list: readonly T[], n: number): T => list[n % list.length];

/** One of the keys of `weights`, each as likely as its weight says. */
export function weighted<K extends string>(weights: ReadonlyArray<readonly [K, number]>, n: number): K {
	let left = n % weights.reduce((sum, [, weight]) => sum + weight, 0);
	for (const [key, weight] of weights) {
		if (left < weight) return key;
		left -= weight;
	}
	return weights[weights.length - 1][0];
}
