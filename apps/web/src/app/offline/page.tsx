export default function Offline() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">You are offline</h1>
      <p className="text-muted">
        BrainPal needs a connection for this. Anything you have already opened
        still works.
      </p>
    </main>
  );
}
