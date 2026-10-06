import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowUnfinishedRequestProgressRun1791380000000 implements MigrationInterface {
  name = 'AllowUnfinishedRequestProgressRun1791380000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "temporary_request_progress_run" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "is4k" boolean NOT NULL DEFAULT (0), "finishedAt" datetime, "snapshot" text NOT NULL, "requestId" integer, CONSTRAINT "REL_d69737bb3395e1654195c5996b" UNIQUE ("requestId"), CONSTRAINT "FK_d69737bb3395e1654195c5996b3" FOREIGN KEY ("requestId") REFERENCES "media_request" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `INSERT INTO "temporary_request_progress_run"("id", "is4k", "finishedAt", "snapshot", "requestId") SELECT "id", "is4k", "finishedAt", "snapshot", "requestId" FROM "request_progress_run"`
    );
    await queryRunner.query(`DROP TABLE "request_progress_run"`);
    await queryRunner.query(
      `ALTER TABLE "temporary_request_progress_run" RENAME TO "request_progress_run"`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "request_progress_run" RENAME TO "temporary_request_progress_run"`
    );
    await queryRunner.query(
      `CREATE TABLE "request_progress_run" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "is4k" boolean NOT NULL DEFAULT (0), "finishedAt" datetime NOT NULL, "snapshot" text NOT NULL, "requestId" integer, CONSTRAINT "REL_d69737bb3395e1654195c5996b" UNIQUE ("requestId"), CONSTRAINT "FK_d69737bb3395e1654195c5996b3" FOREIGN KEY ("requestId") REFERENCES "media_request" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `INSERT INTO "request_progress_run"("id", "is4k", "finishedAt", "snapshot", "requestId") SELECT "id", "is4k", "finishedAt", "snapshot", "requestId" FROM "temporary_request_progress_run" WHERE "finishedAt" IS NOT NULL`
    );
    await queryRunner.query(`DROP TABLE "temporary_request_progress_run"`);
  }
}
