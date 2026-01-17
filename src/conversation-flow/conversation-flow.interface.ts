import { ConversationStep } from './conversation-state.enum';

export interface UserState {
  step: ConversationStep;
  cedula?: string;
  empresas?: { encabezado: string; items: any[] }[];
  termsAccepted?: boolean;
  isFallback?: boolean;
  satisfactionRating?: number;
}
