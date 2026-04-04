import type { MetadataRoute } from 'next';
import sql from '@/lib/db';

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
