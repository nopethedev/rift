export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootServices } = await import("./server/boot");
    await bootServices();
  }
}
