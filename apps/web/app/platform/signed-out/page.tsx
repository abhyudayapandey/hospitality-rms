export default function SignedOut() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Signed out</h1>
      <a href="/platform/signin" className="text-sm underline">
        Sign in again
      </a>
    </div>
  );
}
