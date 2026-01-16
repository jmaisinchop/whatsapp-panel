// src/chat/entities/survey-response.entity.ts

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';
import { Chat } from './chat.entity';

// Definimos los valores posibles para la calificación
export enum SurveyRating {
  MALA = 'MALA',
  REGULAR = 'REGULAR',
  EXCELENTE = 'EXCELENTE',
}

@Entity()
export class SurveyResponse {
  @PrimaryGeneratedColumn()
  id: number;

  // Columna para guardar la calificación: MALA, REGULAR, o EXCELENTE
  @Column({
    type: 'enum',
    enum: SurveyRating,
  })
  rating: SurveyRating;

  // Columna opcional para guardar comentarios adicionales del cliente
  @Column({ type: 'text', nullable: true })
  comment: string;

  // Relación para saber a qué chat pertenece esta encuesta
  @ManyToOne(() => Chat, (chat) => chat.surveyResponses, { onDelete: 'CASCADE' })
  chat: Chat;

  @CreateDateColumn()
  createdAt: Date;
}