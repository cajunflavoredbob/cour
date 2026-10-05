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

const download = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

/**
 * Opens the system share sheet with `blob` where the browser can share
 * files, else saves it as a download. A refused share (no user activation
 * left, permissions) falls back to the download; a cancelled one does not.
 */
export const shareOrDownload = async (
  blob: Blob,
  filename: string,
  title: string,
): Promise<"shared" | "cancelled" | "downloaded"> => {
  const file = new File([blob], filename, { type: blob.type || "image/png" });
  if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return "shared";
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === "AbortError") return "cancelled";
      console.warn("Share refused; saving the image instead", err);
    }
  }
  download(blob, filename);
  return "downloaded";
};
