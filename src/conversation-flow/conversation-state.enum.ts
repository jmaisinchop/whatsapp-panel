// src/conversation-flow/conversation-state.enum.ts

export enum ConversationStep {
  // Estados originales
  START = 0,
  MAIN_MENU = 1,
  
  // Flujo de registro de nombre
  ASK_FOR_NAME = 2,

  // Flujo de consulta de deudas (legado y nuevo)
  DISCLAIMER = 3,
  PEDIR_CEDULA = 4,
  MENU_DEUDAS = 5,
  ELEGIR_EMPRESA = 6,
  POST_DETAILS = 7,
  SURVEY = 8,

  VALIDAR_CEDULA = 9,         // La IA nos dice que el usuario envió una cédula
  TRANSFERIR_AGENTE = 10,     // La IA decidió que se necesita un humano
  FINALIZAR_CONVERSACION = 11, // La IA detectó que la conversación terminó
  MOSTRAR_LISTA_EMPRESAS = 12, // Estado intermedio después de validar la cédula
  MOSTRAR_MENU = 13,


  // --- MODO FALLA ---
  FALLBACK_MENU = 99
  
}