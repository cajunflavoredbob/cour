/** Whether the browser can hand an image file to the system share sheet. */
export const canShareFiles = (): boolean => {
  try {
    return (
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [new File([""], "probe.png", { type: "image/png" })] })
    );
  } catch {
    return false;
  }
};

/**
 * Hands the image to the system share sheet. A cancel is not an error;
 * a refusal (no user activation left, permissions) throws.
 */
export const shareImage = async (
  blob: Blob,
  filename: string,
  title: string,
): Promise<"shared" | "cancelled"> => {
  const file = new File([blob], filename, { type: blob.type || "image/png" });
  try {
    await navigator.share({ files: [file], title });
    return "shared";
  } catch (err) {
    if ((err as { name?: unknown } | null)?.name === "AbortError") return "cancelled";
    throw err;
  }
};

/** Starts a download of the image. Where it lands is the browser's call. */
export const downloadImage = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

/** The image as a data: URL (the page's CSP allows data: images, not blob:). */
export const imageDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(blob);
  });

/** A PNG's pixel size, read from its header. */
export const pngSize = async (blob: Blob): Promise<{ width: number; height: number }> => {
  const header = new DataView(await blob.slice(16, 24).arrayBuffer());
  return { width: header.getUint32(0), height: header.getUint32(4) };
};
