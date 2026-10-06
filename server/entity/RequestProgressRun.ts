import { MediaRequest } from '@server/entity/MediaRequest';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * The progress run of a request, for its pop-up once it left the tracker and for rebuilding it
 * after a restart. Stored when the run starts and replaced by its final state when it ends.
 */
@Entity()
export class RequestProgressRun {
  constructor(init?: Partial<RequestProgressRun>) {
    Object.assign(this, init);
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @OneToOne(() => MediaRequest, { onDelete: 'CASCADE' })
  @JoinColumn()
  public request: MediaRequest;

  @Column({ default: false })
  public is4k: boolean;

  /** Unset while the run is unfinished. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public finishedAt: Date | null;

  /** JSON of the RequestProgress the pop-up renders. */
  @Column({ type: 'text' })
  public snapshot: string;
}
