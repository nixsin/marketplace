/** True for a hostname the public internet can resolve — see dns-name.js. */
export declare function isPublicDnsName(hostname: string): boolean;

/** True for loopback. The weaker check, for internal hosts where a single-label name is normal. */
export declare function isLoopbackHost(hostname: string): boolean;
