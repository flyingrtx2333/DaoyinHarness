const BASE_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'";
export function projectSiteContentSecurityPolicy(preview: boolean): string {
  const ancestors = preview
    ? "https://harness.daoyintech.com https://www.daoyintech.com"
    : "https://harness.daoyintech.com";
  return `${BASE_POLICY}; frame-ancestors ${ancestors}`;
}
