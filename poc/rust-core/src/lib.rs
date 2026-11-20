//! Prototype du coeur Savoire en Rust.
//!
//! Un document texte yrs expose a JavaScript par wasm-bindgen. Le lien avec
//! CodeMirror vit cote JS (js/cm-binding.mjs) ; ici on ne fait que :
//! - appliquer les changements de l'editeur dans une transaction (origine "cm") ;
//! - appliquer les mises a jour distantes et rendre le delta a pousser dans l'editeur ;
//! - annuler / retablir (UndoManager limite a l'origine "cm") ;
//! - positions relatives (StickyIndex) encodees au format Yjs.
//!
//! Les index sont en unites UTF-16, comme CodeMirror et Yjs.

use std::cell::RefCell;
use std::rc::Rc;

use wasm_bindgen::prelude::*;
use yrs::types::{Delta, Observable};
use yrs::undo::{Options as UndoOptions, UndoManager};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{
    Any, Assoc, Doc, GetString, IndexedSequence, OffsetKind, Options, Out, ReadTxn, StateVector,
    StickyIndex, Text, TextRef, Transact, Update,
};

const ORIGIN_EDITOR: &str = "cm";
const ORIGIN_REMOTE: &str = "remote";

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Date, js_name = now)]
    fn date_now() -> f64;
}

fn now_ms() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        date_now() as u64
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

/// Delta a pousser dans l'editeur, encode a plat : [op, valeur, op, valeur, ...]
/// op 0 = garder n, 1 = inserer texte, 2 = supprimer n.
type FlatDelta = Rc<RefCell<Vec<JsValue>>>;

#[wasm_bindgen]
pub struct CoreDoc {
    doc: Doc,
    text: TextRef,
    undo: UndoManager<()>,
    pending_delta: FlatDelta,
    outbox: Rc<RefCell<Vec<Vec<u8>>>>,
}

#[wasm_bindgen]
impl CoreDoc {
    /// `client_id` = 0 : identifiant tire au hasard.
    #[wasm_bindgen(constructor)]
    pub fn new(client_id: f64) -> CoreDoc {
        let mut opts = if client_id > 0.0 {
            Options::with_client_id(yrs::block::ClientID::new(client_id as u64))
        } else {
            Options::default()
        };
        opts.offset_kind = OffsetKind::Utf16;
        let doc = Doc::with_options(opts);
        let text = doc.get_or_insert_text("content");

        // Deltas a rendre a l'editeur : tout ce qui ne vient pas de lui.
        let pending_delta: FlatDelta = Rc::new(RefCell::new(Vec::new()));
        let pd = pending_delta.clone();
        text.observe("savoire-delta", move |txn, event| {
            let from_editor = txn
                .origin()
                .map(|o| o.as_ref() == ORIGIN_EDITOR.as_bytes())
                .unwrap_or(false);
            if from_editor {
                return;
            }
            let mut out = pd.borrow_mut();
            for d in event.delta(txn) {
                match d {
                    Delta::Retain(n, _) => {
                        out.push(JsValue::from_f64(0.0));
                        out.push(JsValue::from_f64(*n as f64));
                    }
                    Delta::Inserted(value, _) => {
                        let s = match value {
                            Out::Any(Any::String(s)) => s.to_string(),
                            other => other.clone().to_string(txn),
                        };
                        out.push(JsValue::from_f64(1.0));
                        out.push(JsValue::from_str(&s));
                    }
                    Delta::Deleted(n) => {
                        out.push(JsValue::from_f64(2.0));
                        out.push(JsValue::from_f64(*n as f64));
                    }
                }
            }
        });

        // Mises a jour a diffuser : tout ce qui n'est pas arrive du reseau.
        let outbox = Rc::new(RefCell::new(Vec::new()));
        let ob = outbox.clone();
        doc.observe_update_v1("savoire-outbox", move |txn, e| {
            let remote = txn
                .origin()
                .map(|o| o.as_ref() == ORIGIN_REMOTE.as_bytes())
                .unwrap_or(false);
            if !remote {
                ob.borrow_mut().push(e.update.clone());
            }
        })
        .expect("observe_update_v1");

        // Options::default() n'existe pas sur wasm (horloge systeme absente) :
        // on fournit Date.now().
        let undo_opts: UndoOptions<()> = UndoOptions {
            capture_timeout_millis: 500,
            tracked_origins: Default::default(),
            capture_transaction: None,
            timestamp: std::sync::Arc::new(now_ms),
            init_undo_stack: Vec::new(),
            init_redo_stack: Vec::new(),
        };
        let mut undo = UndoManager::with_options(undo_opts);
        undo.expand_scope(&doc, &text);
        undo.include_origin(ORIGIN_EDITOR);

        CoreDoc {
            doc,
            text,
            undo,
            pending_delta,
            outbox,
        }
    }

    #[wasm_bindgen(getter, js_name = clientId)]
    pub fn client_id(&self) -> f64 {
        self.doc.client_id().get() as f64
    }

    /// Texte complet.
    #[wasm_bindgen(js_name = toString)]
    pub fn to_string_js(&self) -> String {
        self.text.get_string(&self.doc.transact())
    }

    pub fn length(&self) -> u32 {
        self.text.len(&self.doc.transact())
    }

    /// Changements d'une transaction CodeMirror, en coordonnees du document
    /// d'avant : ranges = [from, to, from, to, ...], inserts[i] pour chaque paire.
    /// Une seule transaction yrs. Rend la mise a jour v1 a diffuser.
    pub fn edit(&mut self, ranges: &[u32], inserts: Vec<String>) -> Vec<u8> {
        {
            let mut txn = self.doc.transact_mut_with(ORIGIN_EDITOR);
            // De la fin vers le debut : les coordonnees d'avant restent valides.
            let n = inserts.len();
            for i in (0..n).rev() {
                let from = ranges[2 * i];
                let to = ranges[2 * i + 1];
                if to > from {
                    self.text.remove_range(&mut txn, from, to - from);
                }
                if !inserts[i].is_empty() {
                    self.text.insert(&mut txn, from, &inserts[i]);
                }
            }
        }
        self.take_outbox()
    }

    /// Applique une mise a jour distante (v1, compatible Yjs).
    /// Rend le delta a appliquer dans l'editeur (format plat).
    #[wasm_bindgen(js_name = applyUpdate)]
    pub fn apply_update(&mut self, update: &[u8]) -> Result<Vec<JsValue>, JsValue> {
        let u = Update::decode_v1(update).map_err(|e| JsValue::from_str(&e.to_string()))?;
        {
            let mut txn = self.doc.transact_mut_with(ORIGIN_REMOTE);
            txn.apply_update(u)
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
        }
        Ok(self.take_delta())
    }

    /// Annule. Rend le delta pour l'editeur ; la mise a jour a diffuser est
    /// ensuite dans takeOutbox().
    pub fn undo(&mut self) -> Vec<JsValue> {
        self.undo.undo_blocking();
        self.take_delta()
    }

    pub fn redo(&mut self) -> Vec<JsValue> {
        self.undo.redo_blocking();
        self.take_delta()
    }

    /// Coupe le regroupement des frappes : la prochaine frappe est une nouvelle etape.
    #[wasm_bindgen(js_name = stopCapturing)]
    pub fn stop_capturing(&mut self) {
        self.undo.reset();
    }

    #[wasm_bindgen(js_name = canUndo)]
    pub fn can_undo(&self) -> bool {
        self.undo.can_undo()
    }

    /// Mises a jour locales pas encore diffusees, fusionnees (v1).
    #[wasm_bindgen(js_name = takeOutbox)]
    pub fn take_outbox(&mut self) -> Vec<u8> {
        let items: Vec<Vec<u8>> = std::mem::take(&mut *self.outbox.borrow_mut());
        match items.len() {
            0 => Vec::new(),
            1 => items.into_iter().next().unwrap(),
            _ => {
                let refs: Vec<&[u8]> = items.iter().map(|v| v.as_slice()).collect();
                yrs::merge_updates_v1(&refs).unwrap_or_default()
            }
        }
    }

    #[wasm_bindgen(js_name = stateVector)]
    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    /// Etat complet, ou difference depuis un vecteur d'etat distant.
    #[wasm_bindgen(js_name = encodeStateAsUpdate)]
    pub fn encode_state_as_update(&self, sv: Option<Vec<u8>>) -> Result<Vec<u8>, JsValue> {
        let sv = match sv {
            Some(b) if !b.is_empty() => {
                StateVector::decode_v1(&b).map_err(|e| JsValue::from_str(&e.to_string()))?
            }
            _ => StateVector::default(),
        };
        Ok(self.doc.transact().encode_state_as_update_v1(&sv))
    }

    /// Position relative (format Yjs encodeRelativePosition).
    /// assoc < 0 : collee au caractere d'avant ; sinon a celui d'apres.
    #[wasm_bindgen(js_name = relativePosition)]
    pub fn relative_position(&self, index: u32, assoc: i32) -> Vec<u8> {
        let assoc = if assoc < 0 { Assoc::Before } else { Assoc::After };
        let txn = self.doc.transact();
        self.text
            .sticky_index(&txn, index, assoc)
            .map(|s| s.encode_v1())
            .unwrap_or_default()
    }

    /// Index absolu d'une position relative, -1 si introuvable.
    #[wasm_bindgen(js_name = resolvePosition)]
    pub fn resolve_position(&self, rel: &[u8]) -> i32 {
        let Ok(s) = StickyIndex::decode_v1(rel) else {
            return -1;
        };
        let txn = self.doc.transact();
        s.get_offset(&txn).map(|o| o.index as i32).unwrap_or(-1)
    }
}

impl CoreDoc {
    fn take_delta(&mut self) -> Vec<JsValue> {
        std::mem::take(&mut *self.pending_delta.borrow_mut())
    }
}
