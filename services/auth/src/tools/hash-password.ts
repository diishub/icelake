/**
 * Prints a bcrypt hash of a password to stdout. Used only by
 * scripts/create-password-account.sh, run inside this service's own image so
 * the hash is produced with the exact bcryptjs version and cost factor the
 * running service verifies against.
 *
 * Never prints the password itself, and never writes anywhere but stdout: the
 * calling script is responsible for getting the hash into the database and
 * discarding it afterwards.
 */
import bcrypt from 'bcryptjs';

async function main(): Promise<void> {
  const password = process.argv[2];
  const costArg = process.argv[3];
  const cost = costArg ? Number(costArg) : 12;

  if (!password) {
    console.error('usage: hash-password.js <password> [cost]');
    process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(cost) || cost < 4 || cost > 15) {
    console.error('cost must be an integer between 4 and 15');
    process.exitCode = 1;
    return;
  }

  const hash = await bcrypt.hash(password, cost);
  process.stdout.write(`${hash}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
