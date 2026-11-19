"""Plant Care: every kind of answer a skill gives, for the extension's tests."""
from ovos_workshop.decorators import intent_handler

from thalovant_skillkit import display
from thalovant_skillkit.skill import ThalovantSkill


class PlantCareSkill(ThalovantSkill):
    def initialize(self):
        self.add_display_action_handler(self.on_tap)

    @intent_handler("water.plants.intent")
    def handle_water(self, message):
        card = display.list_card(
            [display.item("Fern", "today", icon="drop"), display.item("Cactus", "in 9 days")],
            title="Watering", identifier=f"{self.skill_id}:watering",
            actions=[display.action("done", "Done"), display.action("later", "Later")])
        self.log.info("watering card for %s", self.lang_of(message))
        with display.showing(card):
            self.speak_dialog("water.fern")

    @intent_handler("name.plant.intent")
    def handle_name(self, message):
        name = self.get_response("ask.name")
        if name:
            self.speak_to(message, f"{name} it is.", written=f"Named: {name}")
        else:
            self.speak_to(message, "Never mind.")

    @intent_handler("broken.plant.intent")
    def handle_broken(self, message):
        raise RuntimeError("the pot is cracked")

    def on_tap(self, tap, message):
        self.speak_to(message, "Marked as watered." if tap.action == "done" else "Later, then.",
                      display=display.text("All watered", title="Watering",
                                           identifier=f"{self.skill_id}:watered"))
