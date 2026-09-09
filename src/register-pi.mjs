// `node --import ./src/register-pi.mjs …` — resolve pi's packages outside pi's own loader.
import { register } from "node:module";
register("./pi-resolver.mjs", import.meta.url);
