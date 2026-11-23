// Versão web: substitui o @capacitor/core (scripts/build-mobile.mjs --web). Nada de código nativo:
// native.ts vê isNativePlatform() === false e usa os caminhos do navegador.
export const Capacitor = { isNativePlatform: (): boolean => false };
export function registerPlugin<T>(_name: string): T {
  return {} as T;
}
