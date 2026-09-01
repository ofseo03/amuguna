import { BizinfoCollector } from "./bizinfo";
import type { CollectorConstructor } from "./base";
import { FinlifeCollector } from "./finlife";
import { Gov24Collector } from "./gov24";
import { KstartupCollector } from "./kstartup";
import { LocalWelfareCollector } from "./local-welfare";
import { SocialSecurityCollector } from "./social-security";

export { BizinfoCollector } from "./bizinfo";
export { Collector, CollectorError, firstOf, parseAmount } from "./base";
export type { CollectorConstructor, CollectorOptions, FetchLike, FetchOptions } from "./base";
export { FinlifeCollector, TOP_FIN_GRP_NO } from "./finlife";
export { Gov24Collector } from "./gov24";
export { KstartupCollector } from "./kstartup";
export { LocalWelfareCollector } from "./local-welfare";
export { SocialSecurityCollector } from "./social-security";

export const COLLECTORS: Record<string, CollectorConstructor> = {
  bizinfo: BizinfoCollector,
  finlife: FinlifeCollector,
  gov24: Gov24Collector,
  kstartup: KstartupCollector,
  local_welfare: LocalWelfareCollector,
  social_security: SocialSecurityCollector,
};

export const DEFAULT_SOURCE_KEYS = [
  "finlife",
  "gov24",
] as const;
