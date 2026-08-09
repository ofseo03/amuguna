import { BizinfoCollector } from "./bizinfo";
import type { CollectorConstructor } from "./base";
import { FinlifeCollector } from "./finlife";
import { SocialSecurityCollector } from "./social-security";

export { BizinfoCollector } from "./bizinfo";
export { Collector, CollectorError, firstOf, parseAmount } from "./base";
export type { CollectorConstructor, CollectorOptions, FetchLike, FetchOptions } from "./base";
export { FinlifeCollector, TOP_FIN_GRP_NO } from "./finlife";
export { SocialSecurityCollector } from "./social-security";

export const COLLECTORS: Record<string, CollectorConstructor> = {
  social_security: SocialSecurityCollector,
  bizinfo: BizinfoCollector,
  finlife: FinlifeCollector,
};
