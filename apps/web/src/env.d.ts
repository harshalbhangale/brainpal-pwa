// Declared so they can be read with dot access, which is the form Next inlines at build time.
declare namespace NodeJS {
  interface ProcessEnv {
    NEXT_PUBLIC_API_URL?: string;
    NEXT_PUBLIC_GOOGLE_CLIENT_ID?: string;
  }
}
