import { lazy, type ComponentType } from "react";

/**
 * `React.lazy` para módulos com export nomeado. Se o arquivo do pedaço sumiu
 * (nova versão publicada enquanto a aba estava aberta), recarrega a página uma vez.
 */
export function lazyNamed<M extends Record<string, unknown>, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(async () => {
    try {
      const m = await load();
      return { default: m[name] as ComponentType<any> };
    } catch (err) {
      const KEY = "tb-chunk-reload";
      try {
        if (!sessionStorage.getItem(KEY)) {
          sessionStorage.setItem(KEY, "1");
          location.reload();
          return new Promise<never>(() => undefined);
        }
      } catch {
        /* ignore */
      }
      throw err;
    }
  });
}
