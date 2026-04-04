import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SkinFast',
    short_name: 'SkinFast',
    description: 'CS2 skin prices and tradeup calculator',
    start_url: '/',
    display: 'standalone',
    background_color: '#09090b',
    theme_color: '#a171c1',
    icons: [
      { src: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { src: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  };
}
