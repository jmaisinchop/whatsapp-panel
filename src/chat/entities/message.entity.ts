// message.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';
import { Chat } from './chat.entity';
import { MessageSender } from '../../common/enums/message-sender.enum';

@Entity()
export class Message {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Chat, (chat) => chat.messages, { onDelete: 'CASCADE' })
  chat: Chat;

  @Column({
    type: 'enum',
    enum: MessageSender,
  })
  sender: MessageSender;

  @Column({ type: 'int', nullable: true })
  senderId: number;

  @Column({ nullable: true })
  senderName: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ nullable: true })
  mediaUrl: string;

  @Column({ nullable: true })
  mimeType: string;

  @CreateDateColumn()
  timestamp: Date;

  @Column({ type: 'timestamp', nullable: true })
  readAt: Date;
}