//! SpendTree: a conserved spending tree for AI agents on NEAR.
//!
//! A human funds the root. Each agent is a NEAR account that holds only a
//! function-call key to this contract. An agent can hand part of its budget to
//! a sub-agent (`delegate`), pay someone (`pay`) or take back a sub-agent's
//! unspent budget (`revoke`). Delegating removes the parent's authority over
//! that amount, so cloning agents never clones money.
//!
//! Invariant, checked by `get_totals`:
//!   total_deposit == sum(available) + sum(reserved) + sum(spent)

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, Vector};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult};

/// Gas reserved for `on_paid`. A refund after a revoke walks up the tree, so the
/// tree depth is capped (MAX_DEPTH) to keep that walk well inside this budget.
const CALLBACK_GAS: Gas = Gas::from_tgas(40);
/// Root is depth 0. Deep enough for agent -> sub-agent -> helper chains, small
/// enough that the refund walk in `on_paid` is cheap and bounded.
const MAX_DEPTH: u32 = 8;

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Node {
    parent: Option<AccountId>,
    children: Vec<AccountId>,
    /// Total amount this node was given (root: the deposit).
    budget: u128,
    /// Amount currently handed to children and not taken back.
    delegated: u128,
    /// Payments sent but not yet settled.
    reserved: u128,
    /// Payments that settled successfully.
    spent: u128,
    revoked: bool,
}

impl Node {
    fn available(&self) -> u128 {
        self.budget - self.delegated - self.reserved - self.spent
    }
}

#[near(serializers = [json])]
pub struct NodeView {
    pub account: AccountId,
    pub parent: Option<AccountId>,
    pub children: Vec<AccountId>,
    pub budget: U128,
    pub delegated: U128,
    pub reserved: U128,
    pub spent: U128,
    pub available: U128,
    pub revoked: bool,
    pub exposure: U128,
}

#[near(serializers = [json])]
pub struct Totals {
    pub total_deposit: U128,
    pub available: U128,
    pub reserved: U128,
    pub spent: U128,
    pub conserved: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Event {
    pub kind: String,
    pub actor: AccountId,
    pub target: Option<AccountId>,
    pub amount: U128,
    pub ok: bool,
    pub note: String,
    pub block: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SpendTree {
    owner: AccountId,
    root: AccountId,
    total_deposit: u128,
    nodes: IterableMap<AccountId, Node>,
    events: Vector<Event>,
}

#[near]
impl SpendTree {
    /// Fund the tree. The attached deposit becomes the root agent's budget.
    #[init]
    #[payable]
    pub fn new(root: AccountId) -> Self {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, "attach the budget as deposit");
        let mut this = Self {
            owner: env::predecessor_account_id(),
            root: root.clone(),
            total_deposit: deposit,
            nodes: IterableMap::new(b"n"),
            events: Vector::new(b"e"),
        };
        this.nodes.insert(
            root.clone(),
            Node { parent: None, children: vec![], budget: deposit, delegated: 0, reserved: 0, spent: 0, revoked: false },
        );
        this.log("fund", this.owner.clone(), Some(root), deposit, true, "root funded");
        this
    }

    /// Hand `amount` of the caller's available budget to a new sub-agent.
    pub fn delegate(&mut self, child: AccountId, amount: U128) {
        let caller = env::predecessor_account_id();
        let amount = amount.0;
        let mut node = self.active_node(&caller);
        require!(amount > 0, "amount must be positive");
        if amount > node.available() {
            self.log_reject("delegate", caller, Some(child), amount, node.available());
            return;
        }
        require!(!self.nodes.contains_key(&child), "child already has a budget");
        require!(self.depth(&caller) < MAX_DEPTH, "delegation tree too deep");
        node.delegated += amount;
        node.children.push(child.clone());
        self.nodes.insert(caller.clone(), node);
        self.nodes.insert(
            child.clone(),
            Node { parent: Some(caller.clone()), children: vec![], budget: amount, delegated: 0, reserved: 0, spent: 0, revoked: false },
        );
        self.log("delegate", caller, Some(child), amount, true, "");
    }

    /// Pay `recipient` from the caller's available budget. The amount is
    /// reserved until the transfer settles; a failed transfer restores it once.
    pub fn pay(&mut self, recipient: AccountId, amount: U128, memo: Option<String>) -> Option<Promise> {
        let caller = env::predecessor_account_id();
        let amount = amount.0;
        let mut node = self.active_node(&caller);
        require!(amount > 0, "amount must be positive");
        if amount > node.available() {
            self.log_reject("pay", caller, Some(recipient), amount, node.available());
            return None;
        }
        // Make sure the settlement callback can never be starved of gas.
        require!(env::prepaid_gas() >= CALLBACK_GAS.saturating_add(Gas::from_tgas(20)), "attach at least 60 Tgas to pay");
        node.reserved += amount;
        self.nodes.insert(caller.clone(), node);
        self.log("pay_sent", caller.clone(), Some(recipient.clone()), amount, true, &memo.unwrap_or_default());
        Some(
            Promise::new(recipient.clone())
                .transfer(NearToken::from_yoctonear(amount))
                .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_paid(caller, recipient, U128(amount))),
        )
    }

    #[private]
    pub fn on_paid(&mut self, payer: AccountId, recipient: AccountId, amount: U128) -> bool {
        let amount = amount.0;
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        let mut node = self.nodes.get(&payer).expect("payer").clone();
        node.reserved -= amount;
        if ok {
            node.spent += amount;
            self.nodes.insert(payer.clone(), node);
            self.log("pay_settled", payer, Some(recipient), amount, true, "");
            return true;
        }
        // Failed transfer: NEAR refunded the contract. Give the amount back to
        // the payer, or, if the payer was revoked meanwhile, to the nearest
        // active ancestor.
        let revoked = node.revoked;
        if revoked {
            node.budget -= amount;
        }
        let mut parent = node.parent.clone();
        self.nodes.insert(payer.clone(), node);
        if revoked {
            while let Some(p) = parent {
                let mut pn = self.nodes.get(&p).expect("parent").clone();
                pn.delegated -= amount;
                let stop = !pn.revoked;
                if !stop {
                    pn.budget -= amount;
                }
                parent = pn.parent.clone();
                self.nodes.insert(p, pn);
                if stop {
                    break;
                }
            }
        }
        self.log("pay_refunded", payer, Some(recipient), amount, false, "transfer failed, amount restored");
        false
    }

    /// Take back everything a direct sub-agent (and its whole subtree) has not
    /// spent or reserved. The subtree is frozen afterwards.
    pub fn revoke(&mut self, child: AccountId) -> U128 {
        let caller = env::predecessor_account_id();
        let mut node = self.active_node(&caller);
        let c = self.nodes.get(&child).expect("unknown child");
        require!(c.parent.as_ref() == Some(&caller), "only the direct parent can revoke");
        require!(!c.revoked, "already revoked");
        let back = self.freeze(&child);
        node.delegated -= back;
        self.nodes.insert(caller.clone(), node);
        self.log("revoke", caller, Some(child), back, true, "unspent budget returned");
        U128(back)
    }

    // ---------- views ----------

    pub fn get_tree(&self) -> Vec<NodeView> {
        self.nodes
            .iter()
            .map(|(a, n)| NodeView {
                account: a.clone(),
                parent: n.parent.clone(),
                children: n.children.clone(),
                budget: U128(n.budget),
                delegated: U128(n.delegated),
                reserved: U128(n.reserved),
                spent: U128(n.spent),
                available: U128(n.available()),
                revoked: n.revoked,
                exposure: U128(self.subtree_exposure(a)),
            })
            .collect()
    }

    pub fn get_totals(&self) -> Totals {
        let (mut av, mut re, mut sp) = (0u128, 0u128, 0u128);
        for (_, n) in self.nodes.iter() {
            av += n.available();
            re += n.reserved;
            sp += n.spent;
        }
        Totals { total_deposit: U128(self.total_deposit), available: U128(av), reserved: U128(re), spent: U128(sp), conserved: av + re + sp == self.total_deposit }
    }

    /// Blast radius: the most this account's key could ever move if it were
    /// stolen or prompt-injected right now. It is everything still unspent in
    /// its subtree (available + in-flight), because it can only reach money
    /// that was delegated down to it. Spawning sub-agents never increases it.
    pub fn exposure(&self, account: AccountId) -> U128 {
        U128(self.subtree_exposure(&account))
    }

    pub fn get_events(&self, from: Option<u32>) -> Vec<Event> {
        let from = from.unwrap_or(0);
        (from..self.events.len()).filter_map(|i| self.events.get(i).cloned()).collect()
    }

    pub fn get_root(&self) -> AccountId {
        self.root.clone()
    }

    // ---------- internal ----------

    fn depth(&self, account: &AccountId) -> u32 {
        let mut d = 0;
        let mut cur = self.nodes.get(account).and_then(|n| n.parent.clone());
        while let Some(p) = cur {
            d += 1;
            cur = self.nodes.get(&p).and_then(|n| n.parent.clone());
        }
        d
    }

    fn subtree_exposure(&self, account: &AccountId) -> u128 {
        match self.nodes.get(account) {
            None => 0,
            // A revoked key can call nothing; any refund goes to an active ancestor.
            Some(n) if n.revoked => 0,
            Some(n) => {
                let kids: u128 = n.children.iter().map(|c| self.subtree_exposure(c)).sum();
                n.available() + n.reserved + kids
            }
        }
    }

    fn active_node(&self, account: &AccountId) -> Node {
        let n = self.nodes.get(account).unwrap_or_else(|| env::panic_str("caller has no budget"));
        require!(!n.revoked, "caller budget was revoked");
        n.clone()
    }

    /// Freeze `account` and its subtree; return the amount handed back to its parent.
    fn freeze(&mut self, account: &AccountId) -> u128 {
        let mut n = self.nodes.get(account).expect("node").clone();
        if n.revoked {
            return 0;
        }
        for c in n.children.clone() {
            let back = self.freeze(&c);
            n.delegated -= back;
        }
        let give = n.available();
        n.budget -= give;
        n.revoked = true;
        self.nodes.insert(account.clone(), n);
        give
    }

    fn log_reject(&mut self, kind: &str, actor: AccountId, target: Option<AccountId>, amount: u128, available: u128) {
        let note = format!("rejected: asked {} yocto, only {} available", amount, available);
        self.log(&format!("{}_rejected", kind), actor, target, amount, false, &note);
    }

    fn log(&mut self, kind: &str, actor: AccountId, target: Option<AccountId>, amount: u128, ok: bool, note: &str) {
        let e = Event { kind: kind.to_string(), actor, target, amount: U128(amount), ok, note: note.to_string(), block: env::block_height() };
        env::log_str(&format!("EVENT_JSON:{}", near_sdk::serde_json::to_string(&e).unwrap()));
        self.events.push(e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult};

    const ONE: u128 = 1_000_000_000_000_000_000_000_000;

    fn ctx(predecessor: &AccountId, deposit: u128) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("spendtree.near".parse().unwrap())
            .predecessor_account_id(predecessor.clone())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(300));
        testing_env!(b.build());
    }

    fn callback(result: PromiseResult) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("spendtree.near".parse().unwrap())
            .predecessor_account_id("spendtree.near".parse().unwrap())
            .prepaid_gas(Gas::from_tgas(40));
        testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![result]);
    }

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    /// The deepest agent pays, the whole branch above it is revoked before the
    /// transfer settles, then the transfer fails. The refund must walk up the
    /// frozen chain to the first active ancestor and nothing may stay reserved.
    #[test]
    fn failed_payout_after_revoke_returns_to_active_ancestor() {
        let human = accounts(0);
        let chain: Vec<AccountId> = (0..9).map(|i| id(&format!("a{i}.near"))).collect();
        ctx(&human, 10 * ONE);
        let mut c = SpendTree::new(chain[0].clone());
        for i in 0..8 {
            ctx(&chain[i], 0);
            c.delegate(chain[i + 1].clone(), U128((9 - i as u128) * ONE));
        }
        ctx(&chain[8], 0);
        assert!(c.pay(id("nobody.near"), U128(ONE / 2), None).is_some());
        ctx(&chain[0], 0);
        let back = c.revoke(chain[1].clone()).0;
        assert_eq!(back, 9 * ONE - ONE / 2, "everything except the in-flight 0.5 comes back now");
        assert!(c.get_totals().conserved);

        callback(PromiseResult::Failed);
        assert!(!c.on_paid(chain[8].clone(), id("nobody.near"), U128(ONE / 2)));

        let t = c.get_totals();
        assert!(t.conserved);
        assert_eq!(t.reserved.0, 0);
        assert_eq!(t.spent.0, 0);
        let root = c.get_tree().into_iter().find(|n| n.account == chain[0]).unwrap();
        assert_eq!(root.available.0, 10 * ONE, "all 10 NEAR back at the root");
        assert_eq!(c.exposure(chain[8].clone()).0, 0, "a frozen agent has no blast radius");
    }

    #[test]
    fn depth_is_capped() {
        let chain: Vec<AccountId> = (0..10).map(|i| id(&format!("a{i}.near"))).collect();
        ctx(&accounts(0), 10 * ONE);
        let mut c = SpendTree::new(chain[0].clone());
        for i in 0..8 {
            ctx(&chain[i], 0);
            c.delegate(chain[i + 1].clone(), U128(ONE / 10));
        }
        ctx(&chain[8], 0);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.delegate(chain[9].clone(), U128(ONE / 100))));
        assert!(r.is_err(), "9th level must be rejected");
    }

    #[test]
    fn delegation_never_increases_authority() {
        ctx(&accounts(0), 10 * ONE);
        let mut c = SpendTree::new(id("p.near"));
        ctx(&id("p.near"), 0);
        c.delegate(id("r.near"), U128(6 * ONE));
        ctx(&id("r.near"), 0);
        c.delegate(id("h1.near"), U128(4 * ONE));
        c.delegate(id("h2.near"), U128(4 * ONE)); // only 2 left: rejected, logged, no panic
        assert_eq!(c.exposure(id("r.near")).0, 6 * ONE, "spawning helpers does not grow the branch's blast radius");
        assert!(c.get_tree().iter().all(|n| n.account != id("h2.near")));
        assert!(c.get_totals().conserved);
    }
}
