// Static constants
class DamageMultiplier{
	static BONUS = 1.2999999523162841796875;
	static SUPER_EFFECTIVE = 1.60000002384185791015625;
	static RESISTED = .625;
	static DOUBLE_RESISTED = .390625;
	static STAB = 1.2000000476837158203125;
	static SHADOW_ATK = 1.2;
	static SHADOW_DEF = 0.83333331;
	static MEGA_BONUS = [1, 1.10000002384185791015625, 1.2000000476837158203125, 1.2999999523162841796875]
}


/*
* Class with static methods for handling damage calculations
*/

class DamageCalculator {
	static typeEffectivenessCache = new Map();
	static damageCaches = new WeakMap();

	// Ordered, normalized typing preserves the original multiplication order.
	// Species with changing forms select another immutable table automatically.
	static getCachedTypeEffectiveness(types){
		var key = types.map(type => type.toLowerCase()).join("|");
		var table = DamageCalculator.typeEffectivenessCache.get(key);
		if(!table){
			table = [];
			for(var type of Pokemon.getAllTypes()){
				table[type.toLowerCase()] = DamageCalculator.getEffectiveness(type, types);
			}
			Object.freeze(table);
			// Bound custom typing combinations as well as normal game typings.
			if(DamageCalculator.typeEffectivenessCache.size >= 512) DamageCalculator.typeEffectivenessCache.clear();
			DamageCalculator.typeEffectivenessCache.set(key, table);
		}
		return table;
	}

	static getDamageCacheEntry(attacker, defender, move){
		var battle = attacker.getBattle && attacker.getBattle();
		if(!battle || battle.simulationOptimizations !== true || battle.cacheDamage === false) return null;
		var attackers = DamageCalculator.damageCaches.get(battle);
		if(!attackers) DamageCalculator.damageCaches.set(battle, attackers = new WeakMap());
		var defenders = attackers.get(attacker);
		if(!defenders) attackers.set(attacker, defenders = new WeakMap());
		var moves = defenders.get(defender);
		if(!moves) defenders.set(defender, moves = new WeakMap());
		var entry = moves.get(move);
		if(!entry) moves.set(move, entry = {});
		// Only the latest state per weakly referenced pair/move is retained.
		return entry;
	}
	// Calculate damage given an attacker, defender, and move, requires move to be initialized first
	static damage(attacker, defender, move, charge = 1, mode = "simulate", players = []){
		var effectiveness = defender.typeEffectiveness[move.type];
		var chargeMultiplier = charge; // The amount of charge for a Charged Move


		// Fully charge moves in regular simulation or if the opponent is an AI
		if((mode == "emulate")&&(players[attacker.index])){
			if((move.energyGain > 0)||(players[attacker.index].getAI() !== false)){
				chargeMultiplier = 1;
			}

			// Protection to prevent 0 damage
			if(chargeMultiplier == 0){
				chargeMultiplier = 1;
			}
		}

		let power = move.power;
		let attackStat = attacker.getEffectiveStat(0);
		let defenseStat = defender.getEffectiveStat(1);
		let isMegaMove = (attacker.hasTag("mega") && move?.isMegaMove);
		let megaMultiplier = isMegaMove ? DamageMultiplier.MEGA_BONUS[attacker.megaLevel - 1] : 1;

		// Form specific special cases
		switch(attacker.activeFormId){
			case "aegislash_shield":
				// Calculate all Charged Attack damage using the Blade form's Attack stat
				if(move.category == "charged"){
					attackStat = attacker.getFormStats("aegislash_blade").atk;
				}
				break;
		}

		let damage = 1;
		let cache = DamageCalculator.getDamageCacheEntry(attacker, defender, move);
		// Key by final numeric inputs, after stages, Shadow modifiers, forms,
		// mega bonuses and emulation charge rules. HP methods include max HP.
		if(cache && cache.power === power && cache.stab === move.stab && cache.attack === attackStat && cache.defense === defenseStat && cache.effectiveness === effectiveness && cache.charge === chargeMultiplier && cache.mega === megaMultiplier && cache.method === move.damageMethod && cache.hp === defender.stats.hp){
			return cache.damage;
		}

		// Form specific special cases
		switch(attacker.activeFormId){
			case "aegislash_shield":
				//
				if(move.energyGain > 0){
					damage = 1;
				}
				break;
		}

		// Alternative damage method calculations
		switch(move.damageMethod){
			default:
				damage = Math.floor(power * move.stab * ( attackStat / defenseStat) * effectiveness * chargeMultiplier * megaMultiplier * 0.5 * DamageMultiplier.BONUS) + 1;
				break;

			case "percentMaxHP":
				damage = Math.floor((move.power / 100) * (defender.stats.hp)) + 1;
				break;
		}

		if(cache){
			cache.power = power; cache.stab = move.stab; cache.attack = attackStat; cache.defense = defenseStat;
			cache.effectiveness = effectiveness; cache.charge = chargeMultiplier; cache.mega = megaMultiplier;
			cache.method = move.damageMethod; cache.hp = defender.stats.hp; cache.damage = damage;
		}
		return damage;
	}

	// Calculate damage given stats and effectiveness

	static damageByStats(attacker, defender, attack, defense, effectiveness, move){
		// For Pokemon which change forms before a charged attack, use the new form's attack stat
		if(attacker.formChange && attacker.formChange.trigger == "activate_charged" && move.category == "charged"){
			attack = attacker.getFormStats(attacker.formChange.alternativeFormId).atk;
		}

		let isMegaMove = (attacker.hasTag("mega") && move?.isMegaMove);
		let megaMultiplier = isMegaMove ? DamageMultiplier.MEGA_BONUS[attacker.megaLevel - 1] : 1;
		let damage = 1;

		// Form specific special cases
		switch(attacker.activeFormId){
			case "aegislash_shield":
				//
				if(move.energyGain > 0){
					damage = 1;
				}
				break;
		}

		// Alternative damage method calculations
		switch(move.damageMethod){
			default:
				damage = Math.floor(move.power * move.stab * (attack/defense) * megaMultiplier * effectiveness * 0.5 * DamageMultiplier.BONUS) + 1;
				break;

			case "percentMaxHP":
				damage = Math.floor((move.power / 100) * (defender.stats.hp)) + 1;
				break;
		}

		return damage;
	}

	// Solve for Attack given the damage, defense, effectiveness, and move

	static breakpoint(attacker, defender, damage, defense, effectiveness, move){
		var attackStatMultiplier = attacker.getStatBuffMultiplier(0, true);

		var attack = ((damage - 1) * defense) / (move.power * move.stab * effectiveness * attacker.shadowAtkMult * attackStatMultiplier * 0.5 * DamageMultiplier.BONUS);

		return attack;
	}

	// Solve for Defense given the damage, attack, effectiveness, and move

	static bulkpoint(attacker, defender, damage, attack, effectiveness, move){
		var defenseStatMultiplier = defender.getStatBuffMultiplier(1, true);

		var defense =  (move.power * move.stab * effectiveness * 0.5 * DamageMultiplier.BONUS * attack) / (damage);

		defense = (defense * defenseStatMultiplier) / defender.shadowDefMult;

		return defense;
	}


	// Given a move type and array of defensive types, return the final type effectiveness multiplier

	static getEffectiveness(moveType, targetTypes){
		var effectiveness = 1;

		var moveType = moveType.toLowerCase();

		for(var i = 0; i < targetTypes.length; i++){
			var type = targetTypes[i].toLowerCase();
			var traits = DamageCalculator.getTypeTraits(type);

			if(traits.weaknesses.indexOf(moveType) > -1){
				effectiveness *= DamageMultiplier.SUPER_EFFECTIVE;
			} else if(traits.resistances.indexOf(moveType) > -1){
				effectiveness *= DamageMultiplier.RESISTED;
			} else if(traits.immunities.indexOf(moveType) > -1){
				effectiveness *= DamageMultiplier.DOUBLE_RESISTED;
			}
		}

		return effectiveness;
	}

	// Helper function that returns an array of weaknesses, resistances, and immunities given defensive type

	static getTypeTraits(type){
		var traits = {
			weaknesses: [],
			resistances: [],
			immunities: []
		};

		switch(type){
			case "normal":
				traits = { resistances: [],
				  weaknesses: ["fighting"],
				  immunities: ["ghost"] };
				break;

			case "fighting":
				traits = { resistances: ["rock", "bug", "dark"],
				  weaknesses: ["flying", "psychic", "fairy"],
				  immunities: [] };
				break;

			case "flying":
				traits = { resistances: ["fighting", "bug", "grass"],
				  weaknesses: ["rock", "electric", "ice"],
				  immunities: ["ground"] };
				break;

			case "poison":
				traits = { resistances: ["fighting", "poison", "bug", "fairy","grass"],
				  weaknesses: ["ground", "psychic"],
				  immunities: [] };
				break;

			case "ground":
				traits = { resistances: ["poison", "rock"],
				  weaknesses: ["water", "grass", "ice"],
				  immunities: ["electric"] };
				break;

			case "rock":
				traits = { resistances: ["normal", "flying", "poison", "fire"],
				  weaknesses: ["fighting", "ground", "steel", "water", "grass"],
				  immunities: [] };
				break;

			case "bug":
				traits = { resistances: ["fighting", "ground", "grass"],
				  weaknesses: ["flying", "rock", "fire"],
				  immunities: [] };
				break;

			case "ghost":
				traits = { resistances: ["poison", "bug"],
				  weaknesses: ["ghost","dark"],
				  immunities: ["normal", "fighting"] };
				break;

			case "steel":
				traits = { resistances: ["normal", "flying", "rock", "bug", "steel", "grass", "psychic", "ice", "dragon", "fairy"],
				  weaknesses: ["fighting", "ground", "fire"],
				  immunities: ["poison"] };
				break;

			case "fire":
				traits = { resistances: ["bug", "steel", "fire", "grass", "ice", "fairy"],
				  weaknesses: ["ground", "rock", "water"],
				  immunities: [] };
				break;

			case "water":
				traits = { resistances: ["steel", "fire", "water", "ice"],
				  weaknesses: ["grass", "electric"],
				  immunities: [] };
				break;

			case "grass":
				traits = { resistances: ["ground", "water", "grass", "electric"],
				  weaknesses: ["flying", "poison", "bug", "fire", "ice"],
				  immunities: [] };
				break;

			case "electric":
				traits = { resistances: ["flying", "steel", "electric"],
				  weaknesses: ["ground"],
				  immunities: [] };
				break;

			case "psychic":
				traits = { resistances: ["fighting", "psychic"],
				  weaknesses: ["bug", "ghost", "dark"],
				  immunities: [] };
				break;

			case "ice":
				traits = { resistances: ["ice"],
				  weaknesses: ["fighting", "fire", "steel", "rock"],
				  immunities: [] };
				break;

			case "dragon":
				traits = { resistances: ["fire", "water", "grass", "electric"],
				  weaknesses: ["dragon", "ice", "fairy"],
				  immunities: [] };
				break;

			case "dark":
				traits = { resistances: ["ghost", "dark"],
				  weaknesses: ["fighting", "fairy", "bug"],
				  immunities: ["psychic"] };
				break;

			case "fairy":
				traits = { resistances: ["fighting", "bug", "dark"],
				  weaknesses: ["poison", "steel"],
				  immunities: ["dragon"] };
				break;
		}

		return traits;
	}
}
