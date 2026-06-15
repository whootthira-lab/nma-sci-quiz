/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'firebasestorage.googleapis.com' },
      { protocol: 'https', hostname: 'storage.googleapis.com' },
      { protocol: 'https', hostname: 'fal.media' },
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
    serverComponentsExternalPackages: ['fluent-ffmpeg', '@ffmpeg-installer/ffmpeg'],
  },
};

module.exports = nextConfig;
