import { fileURLToPath } from 'node:url';
import { startAegisServer } from '../../../server';

export { startAegisServer };

const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^file:\/\//, ''));

if (isDirectExecution) {
  const port = Number(process.env.PORT ?? 3000) || 3000;
  startAegisServer(port).catch((error) => {
    process.stderr.write(
      `Failed to start Aegis API server: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}
