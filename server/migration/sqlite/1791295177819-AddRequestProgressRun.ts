import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestProgressRun1791295177819 implements MigrationInterface {
  name = 'AddRequestProgressRun1791295177819';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "request_progress_run" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "is4k" boolean NOT NULL DEFAULT (0), "finishedAt" datetime NOT NULL, "snapshot" text NOT NULL, "requestId" integer, CONSTRAINT "REL_d69737bb3395e1654195c5996b" UNIQUE ("requestId"), CONSTRAINT "FK_d69737bb3395e1654195c5996b3" FOREIGN KEY ("requestId") REFERENCES "media_request" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "request_progress_run"`);
  }
}
