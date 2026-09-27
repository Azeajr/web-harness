export interface HeaderRule {
  pattern: string;
  set: [string, string][];
  detach: string[];
  matcher: (pathname: string) => boolean;
}

/** Parse a Cloudflare Pages `_headers` file. */
export declare function parseHeaders(text: string): HeaderRule[];
/** Headers Pages would send for `pathname`, lower-cased names. */
export declare function headersFor(rules: HeaderRule[], pathname: string): Map<string, string>;

export interface StaticServer {
  url: string;
  rules: HeaderRule[];
  close(): Promise<void>;
}

/** Serve a build directory the way Pages does: _headers applied, SPA fallback. */
export declare function createStaticServer(options: {
  dir: string;
  port: number;
  host?: string;
  identity?: { root: string; token: string } | null;
  unservedPrefixes?: string[];
}): Promise<StaticServer>;
