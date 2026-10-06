import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestProgressRun1791295223898 implements MigrationInterface {
  name = 'AddRequestProgressRun1791295223898';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "request_progress_run" ("id" SERIAL NOT NULL, "is4k" boolean NOT NULL DEFAULT false, "finishedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "snapshot" text NOT NULL, "requestId" integer, CONSTRAINT "REL_d69737bb3395e1654195c5996b" UNIQUE ("requestId"), CONSTRAINT "PK_278f92fb66aaf0c2c233f013c93" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `ALTER TABLE "request_progress_run" ADD CONSTRAINT "FK_d69737bb3395e1654195c5996b3" FOREIGN KEY ("requestId") REFERENCES "media_request"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "request_progress_run" DROP CONSTRAINT "FK_d69737bb3395e1654195c5996b3"`
    );
    await queryRunner.query(`DROP TABLE "request_progress_run"`);
  }
}
