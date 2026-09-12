/**
 * Which thinking levels exist, and the one place that says so.
 *
 * A level is a string until it reaches `createAgentSession`, which casts it into pi's
 * `ThinkingLevel` union — so `--thinking hgih` was stored, dispatched, and only noticed when the run
 * failed hours later with pi's own error. The environment boundary validated it (the host's
 * `PI_LOOPS_HOST_THINKING`); the command line and the job store did not.
 *
 * Its own module because both sides need it and neither wants the other: `args.ts` parses commands
 * with no host code in reach, and `host.ts` reads an environment variable with no command parsing.
 */

/** The thinking levels pi knows (`ThinkingLevel` in pi's agent core). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The value if it is a thinking level, undefined if it is anything else (the caller says so and falls back). */
export function thinkingLevelOrUndefined(value: string | undefined): string | undefined {
	return value && (THINKING_LEVELS as readonly string[]).includes(value) ? value : undefined;
}

/**
 * The value, or a refusal that lists what is accepted. For the paths where there is a person to tell
 * and nothing sensible to fall back to: they asked for a level, and silently using another one is
 * worse than saying it does not exist.
 */
export function requireThinkingLevel(value: string): string {
	const level = thinkingLevelOrUndefined(value);
	if (!level) throw new Error(`unknown thinking level "${value}"; pick one of ${THINKING_LEVELS.join(", ")}`);
	return level;
}
