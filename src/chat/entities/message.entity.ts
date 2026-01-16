import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
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

  // --- NUEVOS CAMPOS ---
  @Column({ nullable: true })
  mediaUrl: string; // Guardará la ruta pública del archivo

  @Column({ nullable: true })
  mimeType: string; // Guardará el tipo de archivo (ej. 'image/png')
  // ---------------------

  @CreateDateColumn()
  timestamp: Date;

  @Column({ type: 'timestamp', nullable: true })
  readAt: Date;
}