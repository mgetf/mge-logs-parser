import { parse } from "./parser.ts";
import type { ParsedMatch } from "./types.ts";

export default function (logText: string): ParsedMatch {
  return parse(logText);
}
