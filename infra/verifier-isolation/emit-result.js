/** Write one trusted result frame completely before the caller exits. */
export async function writeResultMarker(result) {
  const line = `ORLOOM-RESULT:${Buffer.from(JSON.stringify(result)).toString('base64')}\n`;
  await new Promise((resolve, reject) => {
    process.stdout.write(line, error => error ? reject(error) : resolve());
  });
}
