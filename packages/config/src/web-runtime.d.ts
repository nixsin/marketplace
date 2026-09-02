/**
 * Reading either of these THROWS on a deployment when the variable is unset.
 * Behind their own subpath so the package's main entry stays safe to import
 * from Node scripts and from apps/api, which do not read them.
 */
export declare const API_URL: string;
export declare const SITE_URL: string;
