import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** A request progress step duration measured by the tracker; see StepStats. */
@Index('IDX_step_sample_server_step', ['serverKey', 'step'])
@Entity()
export class StepSample {
  constructor(init?: Partial<StepSample>) {
    Object.assign(this, init);
  }

  @PrimaryGeneratedColumn()
  public id: number;

  /** Radarr/Sonarr server, e.g. `radarr-0`. */
  @Column()
  public serverKey: string;

  /** A progress step, or `total` for requested -> playable. */
  @Column()
  public step: string;

  // Searches can wait for weeks, beyond a 32-bit integer of milliseconds.
  @Column({
    type: 'bigint',
    transformer: { to: (v: number) => v, from: (v: string) => Number(v) },
  })
  public durationMs: number;

  @DbAwareColumn({ type: 'datetime' })
  public finishedAt: Date;

  @Column({ type: 'varchar', nullable: true })
  public downloadId?: string | null;
}
