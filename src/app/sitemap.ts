import type { MetadataRoute } from 'next';
import sql from '@/lib/db';

// Built per request, not at build time: prerendering it made every deploy
// depend on the database being reachable from the build machine, and a bad
// DATABASE_URL on Vercel failed every production deploy from Nov 2026 on.
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://skinfast.app';

  // Static pages
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      changeFrequency: 'daily',
      priority: 1.0,
    },
    {
      url: `${baseUrl}/tradeups`,
      changeFrequency: 'daily',
      priority: 0.9,
    },
  ];

  // All skin pages
  const skins = await sql<{ id: string }[]>`SELECT id FROM skins`;
  const skinPages: MetadataRoute.Sitemap = skins.map((skin) => ({
    url: `${baseUrl}/skin/${skin.id}`,
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }));

  return [...staticPages, ...skinPages];
}
