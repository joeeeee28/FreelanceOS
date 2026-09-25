/* Run only against an explicitly empty TEST Supabase project.
   This does NOT hit /api/setup. It directly tests transaction rollback behavior with Prisma,
   mirroring the setup transaction shape (AppInit first).
*/
import { PrismaClient } from "@prisma/client";

function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERT FAIL:", msg);
    process.exit(1);
  }
}

async function main() {
  const prisma = new PrismaClient();

  // Precondition: empty
  const pre = await counts(prisma);
  assert(pre.appInit === 0, "Precondition failed: AppInit must be 0");
  assert(pre.workspace === 0, "Precondition failed: Workspace must be 0");
  assert(pre.user === 0, "Precondition failed: User must be 0");
  assert(pre.setting === 0, "Precondition failed: Setting must be 0");
  assert(pre.session === 0, "Precondition failed: Session must be 0");

  // Intentional failure after AppInit creation; must rollback AppInit too.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.appInit.create({ data: { id: 1, initialized: true } });
      // Simulate failure after guard record creation
      throw new Error("INTENTIONAL_TEST_FAILURE");
    });
    assert(false, "Transaction unexpectedly succeeded");
  } catch {
    // expected
  }

  const post = await counts(prisma);
  assert(post.appInit === 0, `Rollback failed: AppInit expected 0, got ${post.appInit}`);
  assert(post.workspace === 0, `Rollback failed: Workspace expected 0, got ${post.workspace}`);
  assert(post.user === 0, `Rollback failed: User expected 0, got ${post.user}`);
  assert(post.setting === 0, `Rollback failed: Setting expected 0, got ${post.setting}`);
  assert(post.session === 0, `Rollback failed: Session expected 0, got ${post.session}`);

  console.log("Rollback test: verified AppInit + all setup entities rolled back.");

  await prisma.$disconnect();
}

async function counts(prisma) {
  const [appInit, workspace, user, setting, session] = await Promise.all([
    prisma.appInit.count(),
    prisma.workspace.count(),
    prisma.user.count(),
    prisma.setting.count(),
    prisma.session.count(),
  ]);
  return { appInit, workspace, user, setting, session };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
