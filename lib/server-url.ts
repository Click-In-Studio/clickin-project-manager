// Absolute base URL for server-side use only (emails, notifications, RSC fetch).
// Never import this in client components — it causes SSR/client hydration mismatch.
// Example: https://backstage.clickinmusical.com
export const SERVER_URL = process.env.BASE_PATH ?? '';
