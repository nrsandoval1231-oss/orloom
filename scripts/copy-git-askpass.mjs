import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const directory=join("dist","packages","integration","src");
await mkdir(directory,{recursive:true});
for(const name of ["git-askpass.sh","git-askpass.cmd","git-askpass.ps1"]) {
  const target=join(directory,name);
  await copyFile(join("packages/integration/src",name),target);
  if(name.endsWith(".sh"))await chmod(target,0o755);
}
