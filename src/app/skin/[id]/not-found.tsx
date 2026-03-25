import Link from 'next/link';

export default function SkinNotFound() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center px-4 gap-4">
      <h1 className="text-2xl font-bold text-white">Skin Not Found</h1>
      <p className="text-zinc-400">The skin you&apos;re looking for doesn&apos;t exist in our database.</p>
      <Link
        href="/"
        className="mt-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg border border-zinc-700 transition-colors text-sm"
      >
        Back to Search
      </Link>
    </div>
  );
}
