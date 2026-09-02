import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnreachableIpv4, isUnreachableIpv6 } from "./host-classification.js";

/**
 * These ranges are the IANA Special-Purpose Address Registries, not a list of
 * addresses somebody thought of.
 *
 * Three review rounds each added one more range -- 127.0.0.0/8, then
 * fec0::/10, then 192.0.0.0/24 -- which is the signal that enumerating
 * instances was the wrong shape. The registry is finite; what people can
 * think of is not. These tests cover every block the function claims, and
 * the PUBLIC address immediately adjacent to each, because a guard that is
 * too broad breaks a real deploy just as surely as one that is too narrow.
 */

const unreachable = [
  ["0.0.0.0", "this network"],
  ["10.0.0.5", "RFC1918"],
  ["100.64.0.1", "CGNAT"],
  ["127.0.0.2", "loopback beyond .1"],
  ["169.254.1.1", "link-local"],
  ["172.16.0.1", "RFC1918"],
  ["192.0.0.1", "IETF protocol assignments"],
  ["192.0.2.1", "TEST-NET-1"],
  ["192.88.99.1", "6to4 relay anycast, deprecated"],
  ["192.168.1.1", "RFC1918"],
  ["198.18.0.1", "benchmarking"],
  ["198.51.100.1", "TEST-NET-2"],
  ["203.0.113.1", "TEST-NET-3"],
  ["224.0.0.1", "multicast"],
  ["255.255.255.255", "broadcast"],
];

const reachable = [
  ["8.8.8.8", "ordinary public"],
  ["1.1.1.1", "ordinary public"],
  ["192.0.1.1", "one block past 192.0.0.0/24"],
  ["192.0.3.1", "one block past TEST-NET-1"],
  ["192.89.99.1", "one block past the 6to4 anycast /24"],
  ["100.63.255.255", "one below CGNAT"],
  ["100.128.0.1", "one above CGNAT"],
  ["198.20.0.1", "one above the benchmarking /15"],
  ["172.32.0.1", "one above the RFC1918 /12"],
  ["10.example.com", "a hostname that merely starts with 10."],
  ["172.16.example.com", "a hostname that merely starts with 172.16."],
];

for (const [address, why] of unreachable) {
  test(`IPv4 ${address} is not reachable (${why})`, () => {
    assert.equal(isUnreachableIpv4(address), true);
  });
}

for (const [address, why] of reachable) {
  test(`IPv4 ${address} IS reachable (${why})`, () => {
    // A guard that is too broad breaks a real deploy. The hostname cases are
    // why the range check parses a dotted quad first rather than matching a
    // prefix on the raw string: `10.example.com` is a perfectly good name.
    assert.equal(isUnreachableIpv4(address), false);
  });
}

const unreachableV6 = [
  ["[::1]", "loopback"],
  ["[::]", "unspecified"],
  ["[fc00::1]", "unique-local"],
  ["[fd00::1]", "unique-local"],
  ["[fe80::1]", "link-local"],
  ["[fec0::1]", "site-local, deprecated by RFC 3879"],
  ["[ff02::1]", "multicast"],
  ["[2001:db8::1]", "documentation"],
  ["[100::1]", "discard-only, RFC 6666"],
  ["[64:ff9b:1::1]", "local-use IPv4/IPv6 translation"],
  ["[2002::1]", "6to4, relays deprecated by RFC 7526"],
  ["[::ffff:127.0.0.1]", "IPv4-mapped loopback, dotted"],
  ["[::ffff:7f00:1]", "IPv4-mapped loopback, hex"],
  ["[::ffff:10.0.0.1]", "IPv4-mapped RFC1918"],
];

const reachableV6 = [
  ["[2606:4700::1111]", "ordinary public"],
  ["[2001:4860:4860::8888]", "ordinary public"],
  ["[::ffff:8.8.8.8]", "IPv4-mapped PUBLIC address"],
  ["2606:4700::1111", "no brackets — URL.hostname always supplies them"],
];

for (const [address, why] of unreachableV6) {
  test(`IPv6 ${address} is not reachable (${why})`, () => {
    assert.equal(isUnreachableIpv6(address), true);
  });
}

for (const [address, why] of reachableV6) {
  test(`IPv6 ${address} IS reachable (${why})`, () => {
    assert.equal(isUnreachableIpv6(address), false);
  });
}
