import type {
  SandBoxAdapter,
  AppInterface,
} from '@micro-app/types'
import globalEnv from '../libs/global_env'
import {
  defer,
  isNode,
  rawDefineProperties,
  rawDefineProperty,
  throttleDeferForSetAppName,
  isMicroAppBody,
} from '../libs/utils'
import {
  appInstanceMap,
  isIframeSandbox,
} from '../create_app'
import microApp from '../micro_app'

export default class Adapter implements SandBoxAdapter {
  constructor () {
    this.injectReactHMRProperty()
  }

  // keys that can only assigned to rawWindow
  public escapeSetterKeyList: PropertyKey[] = [
    'location',
  ]

  // keys that can escape to rawWindow
  public staticEscapeProperties: PropertyKey[] = [
    'System',
    '__cjsWrapper',
  ]

  // keys that scoped in child app
  public staticScopeProperties: PropertyKey[] = [
    'webpackJsonp',
    'webpackHotUpdate',
    'Vue',
  ]

  // adapter for react
  private injectReactHMRProperty (): void {
    if (__DEV__) {
      // react child in non-react env
      this.staticEscapeProperties.push('__REACT_ERROR_OVERLAY_GLOBAL_HOOK__')
      // in react parent
      if (globalEnv.rawWindow.__REACT_ERROR_OVERLAY_GLOBAL_HOOK__) {
        this.staticScopeProperties = this.staticScopeProperties.concat([
          '__REACT_ERROR_OVERLAY_GLOBAL_HOOK__',
          '__reactRefreshInjected',
        ])
      }
    }
  }
}

// Fix conflict of babel-polyfill@6.x
export function fixBabelPolyfill6 (): void {
  if (globalEnv.rawWindow._babelPolyfill) globalEnv.rawWindow._babelPolyfill = false
}

/**
 * Fix error of hot reload when parent&child created by create-react-app in development environment
 * Issue: https://github.com/micro-zoe/micro-app/issues/382
 */
export function fixReactHMRConflict (app: AppInterface): void {
  if (__DEV__) {
    const rawReactErrorHook = globalEnv.rawWindow.__REACT_ERROR_OVERLAY_GLOBAL_HOOK__
    const childReactErrorHook = app.sandBox?.proxyWindow.__REACT_ERROR_OVERLAY_GLOBAL_HOOK__
    if (rawReactErrorHook && childReactErrorHook) {
      globalEnv.rawWindow.__REACT_ERROR_OVERLAY_GLOBAL_HOOK__ = childReactErrorHook
      defer(() => {
        globalEnv.rawWindow.__REACT_ERROR_OVERLAY_GLOBAL_HOOK__ = rawReactErrorHook
      })
    }
  }
}

/**
 * update dom tree of target dom
 * @param container target dom
 * @param appName app name
 */
export function patchElementTree (container: Element | ShadowRoot, appName: string): void {
  const children = Array.from(container.children)

  children.length && children.forEach((child) => {
    patchElementTree(child, appName)
  })

  for (const child of children) {
    updateElementInfo(child, appName)
  }
}

/**
 * rewrite baseURI, ownerDocument, __MICRO_APP_NAME__ of target node
 * @param node target node
 * @param appName app name
 * @returns target node
 */
export function updateElementInfo <T> (node: T, appName: string): T {
  const proxyWindow = appInstanceMap.get(appName)?.sandBox?.proxyWindow
  if (
    isNode(node) &&
    !node.__MICRO_APP_NAME__ &&
    !node.__PURE_ELEMENT__ &&
    proxyWindow
  ) {
    /**
     * TODO:
     *  1. 测试baseURI和ownerDocument在with沙箱中是否正确
     *    经过验证with沙箱不能重写ownerDocument，否则react点击事件会触发两次
     *  2. with沙箱所有node设置__MICRO_APP_NAME__都使用updateElementInfo
    */
    rawDefineProperties(node, {
      baseURI: {
        configurable: true,
        get: () => proxyWindow.location.href,
      },
      __MICRO_APP_NAME__: {
        configurable: true,
        writable: true,
        value: appName,
      },
    })

    if (isIframeSandbox(appName)) {
      /**
       * If HTML built-in node belongs to base app, it needs to be handled separately for parentNode
       * Fix error for nuxt@2.x + ElementUI@2.x
      */
      if (node instanceof globalEnv.rawRootNode) {
        // console.log(11111111, '这里验证一下--删掉', node)
        rawDefineProperty(node, 'parentNode', {
          configurable: true,
          get: createGetterForIframeParentNode(
            appName,
            globalEnv.rawParentNodeDesc,
            true,
          )
        })
      }
    }
  }

  return node
}

/**
 * patch iframe node parentNode
 * Scenes:
 *  1. iframe common node: patch Node.prototype.parentNode to hijack parentNode
 *  2. iframe HTML built-in node: belongs to base app, we should rewrite parentNode for every built-in node
 * NOTE:
 *  1. HTML built-in node parentNode cannot point to raw body, otherwise Vue2 will render failed
 * @param appName app name
 * @param parentNode parentNode Descriptor of iframe or browser
 * @param HTMLBuildInNode is HTML built-in node
 */
export function createGetterForIframeParentNode (
  appName: string,
  parentNodeDesc: PropertyDescriptor,
  HTMLBuildInNode?: boolean,
): () => ParentNode {
  return function (this: Node) {
    /**
     * set current appName for hijack parentNode of html
     * NOTE:
     *  1. Is there a problem with setting the current appName in iframe mode
     */
    throttleDeferForSetAppName(appName)
    const result: ParentNode = parentNodeDesc.get!.call(this)
    /**
      * If parentNode is <micro-app-body>, return rawDocument.body
      * Scenes:
      *  1. element-ui@2/lib/utils/vue-popper.js
      *    if (this.popperElm.parentNode === document.body) ...
      * WARNING:
      *  Will it cause other problems ?
      *  e.g. target.parentNode.remove(target)
      */
    if (
      !HTMLBuildInNode &&
      isMicroAppBody(result) &&
      appInstanceMap.get(appName)?.container
    ) {
      return microApp.options.getRootElementParentNode?.(this, appName) || globalEnv.rawDocument.body
    }
    return result
  }
}
