import GameApp from "./GameApp";
import { chatGPTSignInPath, chatGPTSignOutPath, getChatGPTUser } from "./chatgpt-auth";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ room?: string }>;
}) {
  const params = await searchParams;
  const user = await getChatGPTUser();
  return (
    <GameApp
      hasRoom={Boolean(params.room)}
      user={user ? { displayName: user.displayName, email: user.email } : null}
      signInPath={chatGPTSignInPath(params.room ? `/?room=${encodeURIComponent(params.room)}` : "/")}
      signOutPath={chatGPTSignOutPath("/")}
    />
  );
}
