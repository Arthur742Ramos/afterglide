import { TokenStore } from "xal-node";

/** SDK work can finish after cancellation; gate its writes before it resolves. */
export function ownedTokenStore(
  store: TokenStore,
  isCurrent: () => boolean,
): TokenStore {
  const writes = new Set<PropertyKey>([
    "removeAll",
    "setUserToken",
    "setSisuToken",
    "setJwtKeys",
    "save",
  ]);
  const credentials = new Set<PropertyKey>(["getUserToken", "getSisuToken"]);
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (!isCurrent() && (writes.has(property) || credentials.has(property)))
          return undefined;
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/** Device-code credentials stay private until the current attempt completes. */
export function authenticationTokenStore(): TokenStore {
  const store = new TokenStore();
  store.save = () => {};
  store.removeAll = () => {
    store._userToken = undefined;
    store._sisuToken = undefined;
    store._jwtKeys = undefined;
  };
  return store;
}
