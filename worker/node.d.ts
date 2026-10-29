// Workers har AsyncLocalStorage via nodejs_compat. Vi tar bare med typene vi bruker, i stedet for hele @types/node.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
