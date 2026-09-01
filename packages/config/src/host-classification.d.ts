/**
 * True for an address unreachable from outside the network that issued it:
 * loopback, RFC1918 private, link-local, CGNAT, TEST-NET, multicast and
 * reserved ranges — plus, for IPv6, unique-local, link-local and IPv4-mapped
 * forms in both dotted and hex spellings.
 */
export declare function isUnreachableIpv4(hostname: string): boolean;
export declare function isUnreachableIpv6(hostname: string): boolean;
