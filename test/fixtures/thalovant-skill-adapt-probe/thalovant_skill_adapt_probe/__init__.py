from ovos_workshop.decorators import intent_handler
from ovos_workshop.intents import IntentBuilder
from thalovant_skillkit.skill import ThalovantSkill


class ProbeSkill(ThalovantSkill):
    @intent_handler(IntentBuilder("PingIntent").require("Ping"))
    def handle_ping(self, message):
        self.speak("pong")
