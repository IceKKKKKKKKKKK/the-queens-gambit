import GameApp from "./GameApp";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ room?: string }>;
}) {
  const params = await searchParams;
  return <GameApp hasRoom={Boolean(params.room)} />;
}
