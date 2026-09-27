type UploadFile = { name: string; webkitRelativePath?: string };
export function uploadGroupKeys(kind: string, files: UploadFile[]) {
  const paths = files.map(file => (file.webkitRelativePath || file.name).replaceAll("\\", "/").toLocaleLowerCase());
  const directory = (value: string) => value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : "";
  if (kind !== "video" && kind !== "music") return paths.map((_, index) => `file:${index}`);
  const coverDirectories = kind === "music" ? [...new Set(paths.filter(value => /\.(?:jpg|jpeg|png|webp)$/i.test(value)).map(directory))] : [];
  return paths.map(value => {
    let owner = directory(value);
    if (kind === "video") {
      const parts = owner.split("/");
      const fontFolder = parts.findIndex(part => /^(?:fonts?|字体)$/iu.test(part));
      if (fontFolder >= 0) owner = parts.slice(0, fontFolder).join("/");
    } else {
      // A selected parent cover can be inherited by albums below it. Keeping
      // these files together preserves that relationship during target changes.
      const inherited = coverDirectories.filter(dir => !dir || owner === dir || owner.startsWith(`${dir}/`)).sort((left, right) => left.length - right.length)[0];
      if (inherited !== undefined) owner = inherited;
    }
    return `directory:${owner}`;
  });
}
